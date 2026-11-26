// gate-decision-conflict.spec.ts — T10 409 gate decision conflict & Home NeedsYouCards link.
//
// RETIRED by redesign R2: T10a (inline DecisionBar conflict on Home / Today's
// DecisionCallout). `Home.tsx` replaced `DecisionCallout` with `NeedsYouCards`,
// which links directly to `/approvals/:approvalId`. T10b (CAS 409 conflict on
// `/approvals/:approvalId` when a teammate decides first) stays enforced here.
import { test, expect, apiMutate } from "./fixtures";
import { EMU_ADMIN_STATE, EMU_ALICE_STATE, EMU_BASE_URL } from "./env";

test.use({ storageState: EMU_ADMIN_STATE });

test("T10b: /approvals/:approvalId surfaces honest 409 conflict when gate is already decided", async ({
  browser,
  page,
  request,
  emu,
}) => {
  test.setTimeout(300_000);
  const ts = Date.now().toString(36);
  emu.expectFailure(/\/decide$/, 409);

  // Create a dedicated project where alice is also maintainer so alice can
  // decide the gate out-of-band before admin clicks Approve in DecisionBar.
  const projRes = await apiMutate(page, "POST", `${EMU_BASE_URL}/api/v1/projects`, {
    name: `Emu Gate T10 ${ts}`,
  });
  expect(projRes.status()).toBe(201);
  const project = (await projRes.json()) as { id: string };

  const aliceCtx = await browser.newContext({ storageState: EMU_ALICE_STATE });
  const alicePage = await aliceCtx.newPage();
  const aliceMeRes = await alicePage.request.get(`${EMU_BASE_URL}/api/v1/me`);
  expect(aliceMeRes.ok()).toBe(true);
  const aliceMe = (await aliceMeRes.json()) as { id: string };

  const memberRes = await apiMutate(
    page,
    "PUT",
    `${EMU_BASE_URL}/api/v1/projects/${project.id}/members/${aliceMe.id}`,
    {
      role: "maintainer",
    },
  );
  expect(memberRes.ok()).toBe(true);

  const slug = `emu-gate-${ts}`;
  const pipeRes = await apiMutate(page, "POST", `${EMU_BASE_URL}/api/v1/pipelines`, {
    slug,
    display_name: `Emu Gate ${ts}`,
  });
  expect(pipeRes.status()).toBe(201);
  const pipe = (await pipeRes.json()) as { id: string };

  const yaml = [
    "apiVersion: communication.dev/v1alpha1",
    "kind: Pipeline",
    "metadata:",
    `  name: ${slug}`,
    "spec:",
    "  inputs:",
    "    type: object",
    "  outputs:",
    "    type: object",
    "  nodes:",
    "    - id: gate",
    "      kind: human.approval",
    "      config:",
    '        summary: "Approve emulator T10 test gate"',
    "        approverRoles: [maintainer]",
  ].join("\n");

  const draftRes = await apiMutate(
    page,
    "POST",
    `${EMU_BASE_URL}/api/v1/pipelines/${pipe.id}/drafts`,
    { document_yaml: yaml },
  );
  expect(draftRes.status()).toBe(201);
  const draft = (await draftRes.json()) as { id: string; version: number };

  const valRes = await apiMutate(
    page,
    "POST",
    `${EMU_BASE_URL}/api/v1/drafts/${draft.id}/validate`,
  );
  expect(valRes.ok()).toBe(true);
  const valBody = (await valRes.json()) as { valid?: boolean; errors?: unknown[] };
  expect(valBody.valid, JSON.stringify(valBody.errors ?? [])).toBe(true);
  const refreshedRes = await request.get(`${EMU_BASE_URL}/api/v1/drafts/${draft.id}`);
  expect(refreshedRes.ok()).toBe(true);
  const refreshedDraft = (await refreshedRes.json()) as { version: number };

  const pubRes = await apiMutate(
    page,
    "POST",
    `${EMU_BASE_URL}/api/v1/drafts/${draft.id}/publish`,
    {
      version: refreshedDraft.version,
    },
  );
  expect(pubRes.status()).toBe(201);
  const rev = (await pubRes.json()) as { id: string };

  const assignRes = await apiMutate(
    page,
    "POST",
    `${EMU_BASE_URL}/api/v1/projects/${project.id}/assignments`,
    {
      pipeline_id: pipe.id,
      pinned_revision_id: rev.id,
    },
  );
  expect(assignRes.status()).toBe(201);
  const assignment = (await assignRes.json()) as { id: string };

  const runRes = await apiMutate(
    page,
    "POST",
    `${EMU_BASE_URL}/api/v1/projects/${project.id}/runs`,
    {
      assignment_id: assignment.id,
      inputs: {},
      idempotency: `emu-t10-${ts}`.toLowerCase(),
    },
  );
  expect(runRes.status()).toBe(201);
  const runBody = (await runRes.json()) as { run_id?: string; id?: string };
  const runId = runBody.run_id ?? runBody.id ?? "";
  expect(runId).toMatch(/^[0-9a-f-]{36}$/);

  let pendingRow: { id: string; run_id: string; state: string; version: number } | null = null;
  await expect
    .poll(
      async () => {
        const r = await page.request.get(`${EMU_BASE_URL}/api/v1/approvals?status=pending`);
        if (!r.ok()) return null;
        const d = (await r.json()) as {
          approvals?: { id: string; run_id: string; state: string; version: number }[];
        };
        pendingRow = d.approvals?.find((a) => a.run_id === runId && a.state === "pending") ?? null;
        return pendingRow?.id ?? null;
      },
      { timeout: 25_000 },
    )
    .not.toBeNull();
  const pendingId = pendingRow!.id;
  const gateVersion = pendingRow!.version;

  // Verify Home NeedsYouCards links cleanly before visiting the gate detail page.
  await page.goto(`${EMU_BASE_URL}/`);
  await expect(page.getByTestId("needs-you")).toBeVisible();

  await page.goto(`${EMU_BASE_URL}/approvals/${pendingId}`);
  await expect(page.getByTestId("decision-bar")).toBeVisible();
  // The summary card is a real model call bounded by the lab's own
  // per-completion deadline (COMMUNICATION_ASSISTANT_TIMEOUT, 180 s in
  // compose.real.yml): the capture waits past that bound for the card to leave
  // its loading state (Acceptance 45864491300 was still loading at 15 s).
  await expect(page.locator('[data-testid^="approval-detail-summary-loading-"]')).toHaveCount(0, {
    timeout: 200_000,
  });
  await emu.screen("approval", "detail");

  // Click Approve to enter the 5s undo hold, then Alice decides the gate behind
  // Admin's back via direct API call so Admin's held POST triggers CAS 409.
  await page.getByTestId("decision-approve").click();
  await expect(page.getByTestId("decision-status")).toContainText(
    /Approved\. The run continues in \d+s\./,
    { timeout: 15_000 },
  );

  const decideRes = await apiMutate(
    alicePage,
    "POST",
    `${EMU_BASE_URL}/api/v1/approvals/${pendingId}/decide`,
    { decision: "approved", version: gateVersion },
  );
  expect(decideRes.ok()).toBe(true);
  await aliceCtx.close();

  await expect(page.getByTestId("decision-conflict")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("decision-conflict")).not.toContainText(
    /decision word|winner|control plane|409/i,
  );
});
