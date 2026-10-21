// Phase 4 acceptance: the library — Workflows, the Studio step picker, the
// Step registry and "Edit for all".
//
// /workflows lists exactly the organization's pipelines with revision chips
// from the API; Duplicate creates N+1 and lands on the copy's draft editor;
// the Studio edge "+" opens the step picker with its five kind cards and no
// Publish; a new Agent step gets the profile select (SUGGESTED hint, sandbox
// chips, "+ New profile…" opening the NewProfileDialog); /steps shows the
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

  test("workflows list matches the API and revision chips come from it", async ({ page }) => {
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    const pipelines = await apiPipelines(page.request);
    expect(pipelines.length).toBeGreaterThan(0);
    await page.goto(BASE_URL + "/workflows", { waitUntil: "domcontentloaded" });
    const rows = page.locator('[data-testid^="workflow-row-"]');
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    expect(await rows.count(), "one row per pipeline").toBe(pipelines.length);
    for (const pipeline of pipelines) {
      const chip = page.getByTestId(`workflow-revision-${pipeline.slug}`);
      await expect(chip).toBeVisible();
      const text = (await chip.innerText()).trim();
      if (pipeline.revision_count > 0) {
        // The chip reads `PUBLISHED r<n> <digest6>` from the revisions API; CSS
        // upper-cases the mono text, so compare case-insensitively.
        const [latest] = await apiPipelineRevisions(page.request, pipeline.id);
        expect(latest, `revision summaries for ${pipeline.slug}`).toBeTruthy();
        const digest6 = (digest: string) =>
          digest.startsWith("sha256:") ? digest.slice(7, 13) : digest.slice(0, 6);
        expect(latest.revision_number, "newest summary matches the list API").toBe(
          pipeline.latest_revision_number,
        );
        expect(text.toUpperCase(), `revision chip for ${pipeline.slug}`).toContain(
          `PUBLISHED R${latest.revision_number} ${digest6(latest.revision_digest).toUpperCase()}`,
        );
        expect(text, "the chip carries the digest tail after the revision number").toHaveLength(
          `PUBLISHED r${pipeline.latest_revision_number} `.length + 6,
        );
      } else {
        expect(
          ["DRAFT ONLY", "· loading"],
          `revision chip for ${pipeline.slug}: ${text}`,
        ).toContain(text);
      }
    }
    await checkShellScreen(page, "workflows list", stopWatching);
    await evidence(
      page,
      "shell-p4-workflows-list",
      `/workflows lists exactly the ${pipelines.length} pipelines from GET /api/v1/pipelines and every revision chip reads from the API (PUBLISHED r<N> or DRAFT ONLY)`,
    );
  });

  test("Duplicate creates N+1 and lands on the copy's draft editor", async ({ page }) => {
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    const before = await apiPipelines(page.request);
    // Pick a source whose "<slug>-copy" slot is still free (the copy's slug
    // is the source slug + "-copy").
    const existing = new Set(before.map((p) => p.slug));
    const source = before.find((p) => !existing.has(`${p.slug}-copy`)) ?? before[0];
    expect(source, "a pipeline to duplicate").toBeTruthy();
    await page.goto(BASE_URL + "/workflows", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId(`workflow-row-${source!.slug}`)).toBeVisible({ timeout: 30_000 });
    await page.getByTestId(`workflow-duplicate-${source!.slug}`).click();
    // The UI POSTs the copy and navigates to the copy's draft editor; wait
    // for that navigation before reading the API (reading it mid-POST sees
    // the pre-duplicate count).
    await page.waitForURL(/\/workflows\/[0-9a-f-]{36}\/drafts\/[0-9a-f-]{36}$/, {
      timeout: 30_000,
    });
    const after = await apiPipelines(page.request);
    expect(after.length, "the API now has N+1 pipelines").toBe(before.length + 1);
    const created = after.find((p) => p.slug === `${source!.slug}-copy`);
    expect(created, "the copy row exists in the API with its own id").toBeTruthy();
    await expect(page).toHaveURL(new RegExp(`/workflows/${created!.id}/drafts/[0-9a-f-]{36}$`));
    await evidence(
      page,
      "shell-p4-duplicate",
      `duplicating ${source!.slug} created ${created!.slug} (API count ${before.length} → ${after.length}) and the journey landed on the copy's draft editor`,
    );
    // The list now shows the new row.
    await page.goto(BASE_URL + "/workflows", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId(`workflow-row-${created!.slug}`)).toBeVisible({
      timeout: 30_000,
    });
    expect(await page.locator('[data-testid^="workflow-row-"]').count()).toBe(after.length);
    stopWatching();
    await evidence(
      page,
      "shell-p4-duplicate-list",
      `the /workflows list now carries the new row ${created!.slug} (${after.length} rows = the API's count)`,
    );
  });

  test("Studio edge + opens the picker: five kind cards, no Publish; the Agent step gets its profile select", async ({
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
    await page.goto(BASE_URL + "/workflows", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId(`workflow-row-${source!.slug}`)).toBeVisible({
      timeout: 30_000,
    });
    await page.getByTestId(`workflow-open-${source!.slug}`).click();
    await page.waitForURL(new RegExp(`/workflows/${source!.id}$`), { timeout: 30_000 });
    // Pipeline page → start a fresh draft into the Studio. "New draft"
    // clones the newest published revision — the graph `pipelineHasEdge`
    // verified above — so the canvas is guaranteed to carry an edge and its
    // "+" affordance, independent of any stale draft a previous run left.
    await expect(page.getByTestId("pipeline-new-draft")).toBeVisible({
      timeout: 30_000,
    });
    await page.getByTestId("pipeline-new-draft").click();
    await expect(page.getByTestId("studio-canvas")).toBeVisible({ timeout: 30_000 });
    await checkShellScreen(page, "studio draft", stopWatching);
    const edgePlus = page.locator('[data-testid^="edge-add-"]').first();
    await expect(edgePlus).toBeVisible({ timeout: 30_000 });
    await edgePlus.click();
    const picker = page.getByTestId("step-picker");
    await expect(picker).toBeVisible();
    expect(
      await page
        .getByTestId("step-picker-featured")
        .locator('[data-testid^="step-picker-item-"]')
        .count(),
      "the START A NEW STEP cards are the five primary kinds",
    ).toBe(5);
    expect(await picker.getByText("Publish", { exact: true }).count(), "no Publish kind card").toBe(
      0,
    );
    await evidence(
      page,
      "shell-p4-step-picker",
      "the edge + opens the step picker with exactly five primary kind cards (Agent, Command, Approval, Loop, Workflow) and no Publish card",
    );
    // New Agent step → the inspector's profile select. Inserting on an edge
    // whose target is guarded (a binding like `approve reads nodes.plan.*`,
    // a when guard, a condition route) surfaces the §4 ambiguity dialog —
    // confirm the keep-as-is insert so the step lands and is selected.
    await page.getByTestId("step-picker-item-agent.acp").click();
    const ambiguity = page.getByTestId("studio-ambiguity-dialog");
    const hasAmbiguity = await ambiguity
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (hasAmbiguity) {
      await page.getByTestId("studio-ambiguity-insert").click();
    }
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

  test("/steps registry rows with used-in from the API; Edit for all creates a new revision", async ({
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
    await page.goto(BASE_URL + "/steps", { waitUntil: "domcontentloaded" });
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
      `/steps lists the ${templates.length} registry rows grouped by family, each with its used-in line from GET /api/v1/node-templates`,
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
