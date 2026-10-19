// W4 (wishlist): edit an `agent.acp` step's `config.prompt` through the
// draft editor's per-step form (commit 8f28cb3's nodeFields), publish r1,
// and prove the served facts — the published revision's YAML carries the
// sentinel prompt and its digest differs from the cloned template's.
//
// DEVIATION FROM THE BRIEF, PROVEN NOT ASSUMED: NEITHER shipped library
// template contains an `agent.acp` step. `ui/src/lib/pipeline/templates/`
// holds exactly `plan-with-approval.yaml.txt` and `security-review.yaml.txt`,
// and both say so in their own headers ("no agent.acp node (that kind needs
// ACP harness credentials this worker has none of)"). So this suite clones
// the "Plan with approval" sample the way m5-journey step 1 does, then
// rewrites its `plan` `model.chat` node to an `agent.acp` node through the
// draft editor's authoritative textarea (the same surface the editor itself
// owns — m5-journey does the identical model.chat→process.exec twin). The
// W4 edit itself — the step form's Prompt field writing the sentinel — is
// then performed exactly as specified. Nothing is started: no run.
//
// It runs against the M4 lab by env override only — no second compose
// project:
//   COMMUNICATION_E2E_M5=1 \
//   E2E_BASE_URL=http://localhost:18091 E2E_API_A_URL=http://localhost:18092 \
//   E2E_API_B_URL=http://localhost:18093 pnpm exec playwright test tests/m5-prompt-edit.spec.ts
// The lab's mock IdP "admin" identity (docs/compatibility/probes/m4/seed.sh)
// signs in; this suite adds one library pipeline and one revision and
// resets nothing and cleans nothing up.
//
// Skipped unless COMMUNICATION_E2E_M5=1 (no M4 lab in CI). Every wait is
// bounded: a save/validate/publish that never settles fails the suite
// rather than hanging it. The API assertions use the signed-in browser
// context's own request context (`adminContext.request`, which shares its
// cookies), because every pipeline route below is `HandleAuthed`.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { BASE_URL } from "./env.js";
import { gotoApp, selectByOptionText, shot, signIn } from "./helpers.js";

const M5_ENABLED = process.env.COMMUNICATION_E2E_M5 === "1";

/** A bounded wait for a save/validate/publish round trip. */
const EDIT_TIMEOUT_MS = Number(process.env.E2E_W4_EDIT_TIMEOUT_MS ?? 120_000);

const ADMIN = { subject: "admin", name: "admin" };
const TEMPLATE_LABEL = "Plan with approval";
const stamp = process.env.E2E_W4_STAMP ?? new Date().toISOString().slice(11, 19).replace(/:/g, "");
const SLUG = `w4-prompt-${stamp}`;

/** The prompt the rewritten node ships with, BEFORE the step form edits it. */
const PLACEHOLDER_PROMPT = `W4 draft ${stamp}: the step form replaces this one.`;
/** The W4 sentinel, written by the step form's Prompt field. */
const SENTINEL = `W4 prompt edit ${stamp}: summarize the repository README.`;
const AGENT_PROFILE = "claude-code";

/** A regex that matches `value` literally (the sentinels hold `.` and `:`). */
const literal = (value: string): RegExp => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

/**
 * The session's double-submit CSRF token (internal/api/middleware.go
 * RequireCSRF): the UI's own client reads it out of the `GET /api/v1/me`
 * body and echoes it as `X-CSRF-Token` on every state-changing call, and
 * every POST here is one. The signed-in context's request context shares
 * its cookies, so the same token applies to both the page and these calls.
 */
async function csrfTokenFor(context: BrowserContext): Promise<string> {
  const me = await context.request.get(`${BASE_URL}/api/v1/me`);
  expect(me.status(), "GET /api/v1/me for the CSRF token must be 200").toBe(200);
  const body = (await me.json()) as { csrf_token: string };
  expect(body.csrf_token, "the /me body carries the session's csrf_token").toBeTruthy();
  return body.csrf_token;
}

/**
 * The replacement for the sample's `plan` node: the same node id (the
 * approval node and the artifact node bind the node's `outputs.text` /
 * `outputs` positions and stay intact — that is why the `text` outputs
 * schema is kept), an `agent.acp` kind with the schema's two required
 * config members (`configAgentAcp` requires `profile` and `prompt`), and a
 * placeholder prompt the step form must then replace. No `sessionMode` /
 * `fallback`: both are optional in the schema.
 */
const AGENT_PLAN_NODE = `  - id: plan
    kind: agent.acp
    dependsOn: [survey]
    timeoutSeconds: 600
    config:
      profile: ${AGENT_PROFILE}
      prompt: '${PLACEHOLDER_PROMPT}'
    outputs:
      type: object
      required: [text]
      properties:
        text: {type: string, minLength: 1}`;

test.describe("W4 — edit an agent.acp step's prompt through the step form, publish r1", () => {
  test.describe.configure({ mode: "serial", timeout: 2 * EDIT_TIMEOUT_MS });
  test.skip(
    !M5_ENABLED,
    "Needs the M4 lab stack (ports 18091-18093) — run with COMMUNICATION_E2E_M5=1",
  );

  let adminContext: BrowserContext;
  let admin: Page;
  let pipelinePath = ""; // /library/{pipelineId}
  let draftId = "";
  let templateDigest = ""; // the pristine clone's digest (the baseline)
  let r1Digest = ""; // the published r1's digest

  test.beforeAll(async ({ browser }) => {
    adminContext = await browser.newContext();
    admin = await adminContext.newPage();
  });

  test.afterAll(async () => {
    if (adminContext) await adminContext.close();
  });

  test("the lab is seeded and admin signs in", async ({ request }) => {
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
    await test.step("admin (org admin) signs in", async () => {
      await signIn(admin, ADMIN.subject, { email: `${ADMIN.subject}@example.test` });
      await expect(admin.getByTestId("user-badge")).toHaveText(ADMIN.name);
      await shot(admin, "w4-00-signed-in");
    });
  });

  test("step 1 — admin clones the Plan with approval sample", async () => {
    await test.step("Library → New pipeline → Start from: Plan with approval", async () => {
      await gotoApp(admin, "/library");
      await expect(admin.getByTestId("library-page")).toBeVisible();
      await admin.getByTestId("library-new-slug-input").fill(SLUG);
      await admin.getByTestId("library-new-name-input").fill(SLUG);
      await selectByOptionText(admin, "library-new-template-select", TEMPLATE_LABEL);
      await admin.getByTestId("library-new-submit").click();
      // A template is not a revision: the click path lands on the draft it
      // seeded's Workflow Studio, at /library/:id/drafts/:draftId
      // (m5-journey step 1).
      await admin.waitForURL(/\/library\/[0-9a-f-]{36}\/drafts\/[0-9a-f-]{36}$/);
      const cloneUrl = new URL(admin.url());
      pipelinePath = `/library/${cloneUrl.pathname.split("/")[2]}`;
      draftId = cloneUrl.pathname.split("/").at(-1) ?? "";
      expect(draftId).toMatch(/^[0-9a-f-]{36}$/);
      // The Studio's YAML view is the same authoring surface the old editor
      // exposed as its textarea.
      await admin.getByTestId("studio-view-yaml").click();
      const yaml = admin.getByTestId("studio-yaml");
      await expect(yaml).toHaveValue(new RegExp(SLUG));
      // The sample as shipped: the node this suite must rewrite in step 2.
      await expect(yaml).toHaveValue(/kind: model\.chat/);
      await shot(admin, "w4-01-template-draft");
    });
  });

  test("step 2 — the template's digest, then the plan node becomes agent.acp", async () => {
    await test.step("the pristine clone validates: its digest is the baseline", async () => {
      // The lab's seeded draft still holds the template's bytes, so the
      // server's own verdict on them is the honest baseline: the published
      // r1's digest must differ from THIS one, not from anything computed
      // client-side. The route is authed AND CSRF-checked (POST /validate
      // is a browser mutation behind RequireCSRF — 403 without the
      // X-CSRF-Token header), so the call carries the session token the
      // UI's own client would send.
      const csrf = await csrfTokenFor(adminContext);
      const response = await adminContext.request.post(
        `${BASE_URL}/api/v1/drafts/${draftId}/validate`,
        { headers: { "X-CSRF-Token": csrf } },
      );
      expect(response.status(), "template draft validation must be 200").toBe(200);
      const body = (await response.json()) as {
        valid: boolean;
        revision_digest: string | null;
        errors: unknown[];
      };
      expect(body.valid, `template findings: ${JSON.stringify(body.errors)}`).toBe(true);
      expect(body.revision_digest ?? "").toMatch(/^sha256:[0-9a-f]{64}$/);
      templateDigest = body.revision_digest as string;
    });
    await test.step("the textarea rewrite turns the plan node into an agent.acp step", async () => {
      const input = admin.getByTestId("studio-yaml");
      const doc = await input.inputValue();
      const start = doc.indexOf("\n  - id: plan\n");
      const end = doc.indexOf("\n  - id: approve\n");
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start + 1);
      // One node block out, its `agent.acp` replacement in, the rest of the
      // document byte-identical: the textarea is the editor's own surface.
      await input.fill(doc.slice(0, start + 1) + AGENT_PLAN_NODE + "\n" + doc.slice(end + 1));
      await expect(input).toHaveValue(/kind: agent\.acp/);
      await expect(input).not.toHaveValue(/kind: model\.chat/);
      await expect(input).toHaveValue(literal(PLACEHOLDER_PROMPT));
      await expect(input).toHaveValue(new RegExp(SLUG));
      await shot(admin, "w4-02-agent-node");
    });
  });

  test("step 3 — the step form's Prompt field writes the sentinel", async () => {
    await test.step("open the agent step's per-step form (W4's field set)", async () => {
      // The canvas steps are addressed by node id (survey, plan, approve,
      // publish_plan), so the rewritten node is `canvas-step-plan`.
      await admin.getByTestId("studio-view-canvas").click();
      await admin.getByTestId("canvas-step-plan").click();
      await expect(admin.getByTestId("insp-node")).toBeVisible();
      await expect(admin.getByTestId("insp-kind-chip")).toContainText("agent.acp");
    });
    await test.step("replace the prompt and watch the YAML line change", async () => {
      const prompt = admin.getByTestId("insp-config-prompt");
      // The form reads the document, not a shadow model: it shows exactly
      // what the rewrite put at config.prompt.
      await expect(prompt).toHaveValue(PLACEHOLDER_PROMPT);
      await prompt.fill(SENTINEL);
      // The inspector's textarea fields commit on blur only, so move the
      // focus off the field to land the edit on the document.
      await prompt.press("Tab");
      // The field write lands on the one line its JSON pointer names, so
      // the Studio's YAML view now carries the sentinel verbatim.
      await admin.getByTestId("studio-view-yaml").click();
      const input = admin.getByTestId("studio-yaml");
      await expect(input).toHaveValue(literal(SENTINEL));
      await expect(input).not.toHaveValue(literal(PLACEHOLDER_PROMPT));
      await expect(input).toHaveValue(/kind: agent\.acp/);
      await expect(admin.getByTestId("studio-dirty")).toHaveText("unsaved");
      await shot(admin, "w4-03-prompt-edited");
    });
  });

  test("step 4 — save, validate, publish r1", async () => {
    await test.step("Save → the dirty flag clears; Validate → the server says valid", async () => {
      await admin.getByTestId("studio-save").click();
      await expect(admin.getByTestId("studio-dirty")).toHaveCount(0, {
        timeout: 30_000,
      });
      await admin.getByTestId("studio-validate").click();
      // Publish is gated on the stored verdict, so the verdict is the gate.
      await expect(admin.getByTestId("studio-validate-verdict")).toContainText(/^valid —/, {
        timeout: 30_000,
      });
      await expect(admin.getByTestId("studio-publish")).toBeEnabled();
    });
    await test.step("Publish → r1 is immutable and listed", async () => {
      await admin.getByTestId("studio-publish").click();
      await expect(admin.getByTestId("studio-published")).toContainText("published as r1", {
        timeout: 30_000,
      });
      await gotoApp(admin, pipelinePath);
      await expect(admin.getByTestId("revision-row-1")).toContainText("r1");
      await shot(admin, "w4-04-published-r1");
    });
  });

  test("step 5 — the served facts: the digest moved and the YAML says so", async () => {
    interface RevisionRow {
      revision_number: number;
      revision_digest: string;
      status: string;
    }
    await test.step("the published r1's digest differs from the template's", async () => {
      const pipelineId = pipelinePath.slice("/library/".length);
      const listResponse = await adminContext.request.get(
        `${BASE_URL}/api/v1/pipelines/${pipelineId}/revisions`,
      );
      expect(listResponse.ok()).toBeTruthy();
      const list = (await listResponse.json()) as { revisions: RevisionRow[] };
      const r1 = list.revisions.find((row) => row.revision_number === 1);
      expect(r1, `revisions: ${JSON.stringify(list.revisions)}`).toBeDefined();
      expect(r1?.revision_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(r1?.revision_digest, "the prompt edit must move the digest").not.toBe(templateDigest);
      r1Digest = r1?.revision_digest ?? "";
    });
    await test.step("the revision's YAML carries the sentinel on the agent step", async () => {
      const documentResponse = await adminContext.request.get(
        `${BASE_URL}/api/v1/revisions/${r1Digest}/document?format=yaml`,
      );
      expect(documentResponse.ok()).toBeTruthy();
      const text = await documentResponse.text();
      expect(text).toContain("kind: agent.acp");
      expect(text).toContain(SENTINEL);
      expect(text).not.toContain(PLACEHOLDER_PROMPT);
      expect(text).toContain("id: plan");
    });
    await test.step("the UI's YAML view shows the same served bytes", async () => {
      await gotoApp(admin, pipelinePath);
      await admin.getByTestId("revision-row-1").click();
      const yaml = admin.getByTestId("yaml-view");
      await expect(yaml).toBeVisible({ timeout: 30_000 });
      await expect(yaml).toContainText(SENTINEL);
      await expect(yaml).toContainText("agent.acp");
      await shot(admin, "w4-05-revision-yaml");
    });
  });
});
