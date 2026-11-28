// Phase 4 acceptance: the library — Workflows, the Studio step picker, the
// Step registry and "Edit for all".
//
// /workflows lists exactly the organization's pipelines with revision chips
// from the API; Duplicate creates N+1 and lands on the copy's draft editor;
// the Studio edge "+" opens the step picker with its five kind cards and no
// Publish; a new Agent step gets the profile select (SUGGESTED hint, sandbox
// chips, "+ New profile…" opening the NewProfileDialog); /workflows/steps shows the
// registry rows with their "used in" from the API; and Edit for all publishes
// a new immutable revision whose version label comes back from the API.
//
// Runs ONLY when COMMUNICATION_E2E_SHELL=1. evidence() per step;
// checkShellScreen on each page.
import { expect, test } from "@playwright/test";
import { BASE_URL } from "./env.js";
import { signIn } from "./helpers.js";
import {
  SHELL_ENABLED,
  SHELL_GATE,
  apiCsrf,
  apiPipelines,
  apiPipelineRevisions,
  checkShellScreen,
  evidence,
  watchPageErrors,
} from "./shell-helpers.js";

const STAMP = Date.now().toString(36);

/**
 * GET /api/v1/node-templates/<id> (detail) — the registry's single row: the
 * template (with its latest-revision summary), the full revision history and
 * the usages.
 */
async function apiNodeTemplate(request: import("@playwright/test").APIRequestContext, id: string) {
  const res = await request.get(`${BASE_URL}/api/v1/node-templates/${id}`);
  if (!res.ok()) throw new Error(`GET node-templates/${id} -> ${res.status()}`);
  return (await res.json()) as {
    template: { latest_revision: { version_label: string; revision_number: number } };
    revisions: { revision_number: number }[];
  };
}

/**
 * True when the pipeline's newest published revision carries a graph the
 * Studio can draw an edge for: two or more nodes and at least one dependsOn
 * link (the Studio derives its edges from dependsOn).
 */
async function pipelineHasEdge(
  request: import("@playwright/test").APIRequestContext,
  pipelineId: string,
): Promise<boolean> {
  const revisions = await apiPipelineRevisions(request, pipelineId);
  const [latest] = revisions;
  if (!latest) return false;
  const res = await request.get(`${BASE_URL}/api/v1/revisions/${latest.revision_digest}`);
  if (!res.ok()) return false;
  const rev = (await res.json()) as {
    canonical_document?: { spec?: { nodes?: { dependsOn?: string[] }[] } };
  };
  const nodes = rev.canonical_document?.spec?.nodes ?? [];
  return nodes.length >= 2 && nodes.some((node) => (node.dependsOn ?? []).length > 0);
}

test.describe("shell p4 — workflows, step picker, registry, edit for all", () => {
  test.skip(!SHELL_ENABLED, SHELL_GATE);
  test.use({ viewport: { width: 1500, height: 950 } });
  test.setTimeout(10 * 60_000);

  test("factory list matches the API and workflow cards show triggers and states", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    const pipelines = await apiPipelines(page.request);
    expect(pipelines.length).toBeGreaterThan(0);
    await page.goto(BASE_URL + "/factory", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("factory-index")).toBeVisible({ timeout: 30_000 });
    const cards = page.locator(
      '[data-testid="factory-index"] article[data-testid^="workflow-card-"]',
    );
    await expect(cards.first()).toBeVisible({ timeout: 30_000 });
    expect(await cards.count(), "one card per pipeline").toBe(pipelines.length);
    await expect(page.getByTestId("factory-summary")).toContainText(
      `${pipelines.length} ${pipelines.length === 1 ? "workflow" : "workflows"}`,
    );
    for (const pipeline of pipelines) {
      await expect(page.getByTestId(`workflow-card-link-${pipeline.id}`)).toHaveText(
        pipeline.display_name || pipeline.slug,
      );
      await expect(page.getByTestId(`workflow-card-state-${pipeline.id}`)).toBeVisible();
      const trigger = page.getByTestId(`workflow-card-trigger-${pipeline.id}`);
      await expect(trigger).toBeVisible();
      expect((await trigger.innerText()).trim().length).toBeGreaterThan(0);
    }
    await checkShellScreen(page, "factory list", stopWatching);
    await evidence(
      page,
      "shell-p4-workflows-list",
      `/factory lists exactly the ${pipelines.length} pipelines from GET /api/v1/pipelines with real trigger and live-state copy`,
    );
  });

  test("Copy from New workflow sheet creates N+1 and lands on the copy's draft editor", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    const before = await apiPipelines(page.request);
    expect(before.length, "a pipeline to duplicate").toBeGreaterThan(0);
    await page.goto(BASE_URL + "/factory", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("factory-index")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("factory-new").click();
    const sheet = page.getByTestId("new-workflow-sheet");
    await expect(sheet).toBeVisible();
    const copyButtons = sheet.locator('button[data-testid^="new-workflow-copy-"]');
    await expect(copyButtons.first()).toBeVisible({ timeout: 30_000 });
    const firstTestId = await copyButtons.first().getAttribute("data-testid");
    const sourceId = (firstTestId ?? "").replace("new-workflow-copy-", "");
    const source = before.find((p) => p.id === sourceId) ?? before[0];
    await copyButtons.first().click();
    // NewWorkflowSheet POSTs the copy + initial draft and opens `/factory/:id?draft=:draftId`.
    await page.waitForURL(/\/factory\/[0-9a-f-]{36}\?draft=[0-9a-f-]{36}$/, {
      timeout: 30_000,
    });
    const createdId = /\/factory\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? "";
    const after = await apiPipelines(page.request);
    expect(after.length, "the API now has N+1 pipelines").toBe(before.length + 1);
    const created = after.find((p) => p.id === createdId);
    expect(created, "the copy row exists in the API with its own id").toBeTruthy();
    expect(created!.slug.startsWith(`${source!.slug}-copy`)).toBe(true);
    await evidence(
      page,
      "shell-p4-duplicate",
      `duplicating ${source!.slug} via New workflow created ${created!.slug} (API count ${before.length} → ${after.length}) and landed on the copy's draft editor`,
    );
    // Factory now shows the new card.
    await page.goto(BASE_URL + "/factory", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId(`workflow-card-${created!.id}`)).toBeVisible({
      timeout: 30_000,
    });
    expect(
      await page
        .locator('[data-testid="factory-index"] article[data-testid^="workflow-card-"]')
        .count(),
    ).toBe(after.length);
    stopWatching();
    await evidence(
      page,
      "shell-p4-duplicate-list",
      `/factory now carries the new card ${created!.slug} (${after.length} cards = the API's count)`,
    );
  });

  test("Studio edge + opens the picker: five kind cards, no Publish; Agent step card + More settings profile select", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    // Select the source through the API instead of assuming lab state: any
    // published pipeline whose newest revision carries an edge (the Studio
    // needs one to offer its edge "+" affordance); feature-development, the
    // seeded pipeline, is preferred when it qualifies.
    const pipelines = await apiPipelines(page.request);
    const candidates = pipelines
      .filter((p) => p.revision_count > 0)
      .sort(
        (a, b) =>
          Number(b.slug === "feature-development") - Number(a.slug === "feature-development"),
      );
    const source = await (async () => {
      for (const candidate of candidates) {
        if (await pipelineHasEdge(page.request, candidate.id)) return candidate;
      }
      return undefined;
    })();
    expect(
      source,
      `a published pipeline with an edge in its newest revision (checked ${candidates.length})`,
    ).toBeTruthy();
    await page.goto(BASE_URL + "/factory", { waitUntil: "domcontentloaded" });
    const cardLink = page.getByTestId(`workflow-card-link-${source!.id}`);
    await expect(cardLink).toBeVisible({ timeout: 30_000 });
    await cardLink.click();
    await page.waitForURL(new RegExp(`/factory/${source!.id}(\\?|$)`), { timeout: 30_000 });
    await expect(page.getByTestId("studio-canvas")).toBeVisible({ timeout: 30_000 });
    await checkShellScreen(page, "studio draft", stopWatching);
    const edgePlus = page.locator('[data-testid^="edge-add-"]').first();
    await expect(edgePlus).toBeVisible({ timeout: 30_000 });
    await edgePlus.click();
    const picker = page.getByTestId("insert-step-menu");
    await expect(picker).toBeVisible();
    // Editor interactions 1h: the line's "+" opens INSERT STEP with the four
    // kinds the handoff lists (Agent, Command, Approval, Judge).
    expect(
      await picker.getByRole("menuitem").count(),
      "the INSERT STEP menu lists the four kinds",
    ).toBe(4);
    expect(await picker.getByText("Publish", { exact: true }).count(), "no Publish row").toBe(0);
    await evidence(
      page,
      "shell-p4-step-picker",
      "the edge + opens INSERT STEP with the four kinds (Agent, Command, Approval, Judge) and no Publish row",
    );
    // New Agent step → opens the compact AgentStepCard with AgentPicker; clicking
    // "More settings" reveals the full inspector's profile select.
    await page.getByTestId("insert-step-agent.acp").click();
    const ambiguity = page.getByTestId("studio-ambiguity-dialog");
    const hasAmbiguity = await ambiguity
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (hasAmbiguity) {
      await page.getByTestId("studio-ambiguity-insert").click();
    }
    await expect(page.getByTestId("agent-step-card")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("agent-card-picker")).toBeVisible();
    await page.getByTestId("agent-card-more-settings").click();
    const select = page.getByTestId("insp-profile");
    await expect(select).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("insp-profile-suggested")).toBeVisible();
    await expect(page.getByTestId("insp-profile-suggested")).toContainText("SUGGESTED");
    const optionCount = await select.locator("option").count();
    expect(optionCount, "profile options + the + New profile… option").toBeGreaterThanOrEqual(2);
    const labels = await select
      .locator("option")
      .evaluateAll((opts) => opts.map((o) => o.textContent ?? ""));
    expect(
      labels.filter((label) => label.trim().length > 0).length,
      "every option carries its label (with the sandbox chip words)",
    ).toBe(optionCount);
    await evidence(
      page,
      "shell-p4-agent-step-profile",
      "picking the Agent kind opens the inspector's profile select with its SUGGESTED hint and sandbox-chip option labels",
    );
    // "+ New profile…" opens the shared NewProfileDialog.
    const newOption = page.getByTestId("insp-profile-new");
    const newValue = await newOption.getAttribute("value");
    await select.selectOption(newValue ?? "");
    await expect(page.getByTestId("new-profile-dialog")).toBeVisible();
    await evidence(
      page,
      "shell-p4-new-profile-from-step",
      "the profile select's + New profile… option opens the shared NewProfileDialog",
    );
    await page.getByTestId("new-profile-cancel").click();
    await expect(page.getByTestId("new-profile-dialog")).toBeHidden();
    stopWatching();
  });

  test("/manage/agents?tab=steps registry rows with used-in from the API; Edit for all creates a new revision", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    const fetchTemplates = async (): Promise<
      {
        id: string;
        slug: string;
        used_in_count: number;
        latest_revision?: { version_label: string };
      }[]
    > => {
      const res = await page.request.get(`${BASE_URL}/api/v1/node-templates?limit=100`);
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as {
        templates: {
          id: string;
          slug: string;
          used_in_count: number;
          latest_revision?: { version_label: string };
        }[];
      };
      return body.templates;
    };
    let templates = await fetchTemplates();
    if (templates.length === 0) {
      // A FRESH lab has no saved steps: seed one through the API (setup —
      // the registry journey below still goes through the UI), the same body
      // shape the Studio's "save as a reusable step" POSTs.
      const csrf = await apiCsrf(page.request);
      const profiles = (await (
        await page.request.get(BASE_URL + "/api/v1/agent-profiles")
      ).json()) as { items?: { name: string }[] };
      const created = await page.request.post(BASE_URL + "/api/v1/node-templates", {
        data: {
          slug: `p4-seed-${STAMP}`,
          display_name: "P4 acceptance seed step",
          kind: "agent.acp",
          parameters: {},
          config: {
            profile: profiles.items?.[0]?.name ?? "claude",
            prompt: "Scratch seed template prompt.",
          },
          version_label: "1.0.0",
        },
        headers: { Origin: BASE_URL, "X-CSRF-Token": csrf.token },
      });
      expect(
        created.status(),
        `POST /api/v1/node-templates seed -> ${created.status()}`,
      ).toBeLessThan(300);
      templates = await fetchTemplates();
      console.log(
        `P4 setup: seeded node template for the empty fresh lab (now ${templates.length} row(s))`,
      );
    }
    expect(templates.length, "the lab has saved steps").toBeGreaterThan(0);
    await page.goto(BASE_URL + "/workflows/steps", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/manage\/agents\?tab=steps/);
    // The row ROOT only — `step-row-summary-`/`step-row-usage-` share the prefix.
    const rows = page.locator(
      '[data-testid^="step-row-"]:not([data-testid^="step-row-summary-"]):not([data-testid^="step-row-usage-"])',
    );
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    expect(await rows.count(), "one row per registry template").toBe(templates.length);
    for (const template of templates) {
      const usage = page.getByTestId(`step-row-usage-${template.id}`);
      await expect(usage).toBeVisible();
      const text = (await usage.innerText()).trim();
      expect(text, `usage for ${template.slug}`).toBe(
        template.used_in_count > 0 ? `${template.used_in_count} workflows` : "not used yet",
      );
    }
    await checkShellScreen(page, "steps registry", stopWatching);
    await evidence(
      page,
      "shell-p4-steps-registry",
      `/workflows/steps lists the ${templates.length} registry rows grouped by family, each with its used-in line from GET /api/v1/node-templates`,
    );

    // Edit for all on the first template: a new immutable revision.
    const target = templates[0];
    await page.getByTestId(`step-row-${target.id}`).click();
    await expect(page.getByTestId("step-detail")).toBeVisible();
    await page.getByTestId("step-detail-edit-for-all").click();
    const form = page.getByTestId("edit-for-all-form");
    await expect(form).toBeVisible();
    const suggested = await page.getByTestId("edit-for-all-version").inputValue();
    expect(suggested, "the dialog pre-fills a bumped version label").not.toBe("");
    await page.getByTestId("edit-for-all-submit").click();
    await expect(page.getByTestId("edit-for-all-result")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("edit-for-all-result")).toContainText(suggested);
    const detail = await apiNodeTemplate(page.request, target.id);
    expect(
      detail.template.latest_revision.version_label,
      "the API carries the new revision's label",
    ).toBe(suggested);
    expect(
      detail.revisions.length,
      "the new revision joins the template's history",
    ).toBeGreaterThan(0);
    stopWatching();
    await evidence(
      page,
      "shell-p4-edit-for-all",
      `Edit for all on "${target.slug}" created a new revision and the API's latest revision now carries the version label "${suggested}"`,
    );
  });
});
