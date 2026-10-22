/**
 * The 4g approval detail as a real route. The contract under test:
 * - a 503 `assistant_not_configured` names the cause and falls back to the
 *   gate's own summary plus the static Approve/Reject pair — never a fake
 *   model voice;
 * - NOTHING decides before the human confirms: the decide route is not
 *   called on tapping a suggested button, and Escape closes the confirm
 *   step without deciding;
 * - the suggested actions are colored by risk and the plan artifact renders
 *   inline from `/artifacts/{id}/content`;
 * - "OR IN YOUR WORDS" → interpret → the proposal is shown, and only its
 *   confirmed confirm calls decide, with the proposed note.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import {
  mockFetch,
  requestsTo,
  meFixture,
  projectFixture,
  artifactId,
  type RouteStub,
} from "../test/fakes";
import {
  WIRE_APPROVAL_ID,
  WIRE_RUN_ID,
  wireApproval,
  wireProjectId,
  wireUserId,
} from "../test/fixtures/m4/wire";
import { testidOf } from "../lib/format";
import ApprovalPage from "./Approval";

const T = testidOf(WIRE_APPROVAL_ID);
const APPROVAL_PATH = `/api/v1/approvals/${WIRE_APPROVAL_ID}`;
const SUMMARY_PATH = `${APPROVAL_PATH}/summary`;
const INTERPRET_PATH = `${APPROVAL_PATH}/interpret`;
const DECIDE_PATH = `${APPROVAL_PATH}/decide`;
const ARTIFACTS_PATH = `/api/v1/projects/${wireProjectId}/artifacts`;
const CONTENT_PATH = `/api/v1/artifacts/${artifactId}/content`;

const NOT_CONFIGURED = {
  type: "https://communication.dev/errors/assistant_not_configured",
  title: "Assistant not configured",
  status: 503,
  detail: "no assistant endpoint is configured",
  degraded: "assistant_not_configured",
};

const PLAN_CONTENT =
  "# Plan\n\nToken bucket per API key, stored in Redis.\n\n## Acceptance\n\nThe 61st request gets 429.";

const planArtifact = {
  id: artifactId,
  project_id: wireProjectId,
  run_id: WIRE_RUN_ID,
  name: "plan.md",
  kind: "markdown",
  media_type: "text/markdown",
  sha256: "ab".repeat(32),
  size_bytes: PLAN_CONTENT.length,
  sensitivity: "standard",
  state: "ready",
  redaction_count: 0,
  created_by: wireUserId,
  created_at: "2026-07-31T10:00:00Z",
};

const decidedApproval = {
  ...wireApproval,
  state: "decided",
  decision: "approved",
  decided_by: wireUserId,
  decided_at: "2026-07-31T12:00:00Z",
  version: 2,
};

const BASE_STUBS: RouteStub[] = [
  { path: "/api/v1/me", body: meFixture },
  { path: "/api/v1/projects", body: { items: [projectFixture] } },
  { path: APPROVAL_PATH, method: "GET", body: wireApproval },
  { path: DECIDE_PATH, method: "POST", body: decidedApproval },
];

function renderApprovalPage(extra: RouteStub[]) {
  const { requests } = mockFetch([...BASE_STUBS, ...extra]);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/approvals/${WIRE_APPROVAL_ID}`]}>
        <Routes>
          <Route path="/approvals/:approvalId" element={<ApprovalPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests, queryClient };
}

function textOf(element: Element): string {
  return element.textContent ?? "";
}

afterEach(cleanup);

describe("approval detail (4g)", () => {
  it("falls back to the gate's own summary when the assistant is not configured", async () => {
    renderApprovalPage([
      { path: SUMMARY_PATH, method: "POST", status: 503, body: NOT_CONFIGURED },
      { path: ARTIFACTS_PATH, body: { artifacts: [] } },
    ]);

    const strip = await screen.findByTestId(`approval-detail-strip-${T}`);
    expect(textOf(strip)).toContain("NEEDS YOUR DECISION");
    expect(textOf(strip)).toContain("on timeout: fail");

    expect(await screen.findByTestId(`approval-detail-summary-unconfigured-${T}`)).toBeTruthy();
    expect(textOf(screen.getByTestId(`approval-detail-summary-fallback-${T}`))).toContain(
      wireApproval.summary,
    );

    // No model, no model buttons: the gate's own pair.
    const suggested = screen.getByTestId(`approval-detail-suggested-${T}`);
    const approve = within(suggested).getByTestId(`approval-detail-suggested-${T}-approve`);
    const reject = within(suggested).getByTestId(`approval-detail-suggested-${T}-reject`);
    expect(approve.className).toContain("ds-btn--primary");
    expect(reject.className).toContain("ds-btn--danger");

    expect(textOf(screen.getByTestId(`approval-detail-files-${T}`))).toContain("Not available yet");
    expect(textOf(await screen.findByText(/named by the gate but not in this project/))).toContain(
      "artifact list",
    );
  });

  it("does not call decide until the human confirms, and Escape closes the step", async () => {
    const { requests } = renderApprovalPage([
      { path: SUMMARY_PATH, method: "POST", status: 503, body: NOT_CONFIGURED },
      { path: ARTIFACTS_PATH, body: { artifacts: [] } },
    ]);

    await screen.findByTestId(`approval-detail-strip-${T}`);
    const suggested = screen.getByTestId(`approval-detail-suggested-${T}`);
    const approveButton = within(suggested).getByTestId(`approval-detail-suggested-${T}-approve`);

    fireEvent.click(approveButton);
    const dialog = screen.getByTestId(`approval-detail-confirm-${T}`);
    expect(textOf(dialog)).toContain("Confirm the decision");
    expect(textOf(dialog)).toContain("approved");
    expect(requestsTo(requests, DECIDE_PATH, "POST")).toHaveLength(0);

    // Escape closes the step without deciding.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId(`approval-detail-confirm-${T}`)).toBeNull();
    expect(requestsTo(requests, DECIDE_PATH, "POST")).toHaveLength(0);

    // Confirming calls decide exactly once, with the CAS version.
    fireEvent.click(within(suggested).getByTestId(`approval-detail-suggested-${T}-approve`));
    fireEvent.click(screen.getByTestId(`approval-detail-confirm-go-${T}`));

    await waitFor(() => expect(requestsTo(requests, DECIDE_PATH, "POST")).toHaveLength(1));
    const body = JSON.parse(requestsTo(requests, DECIDE_PATH, "POST")[0].body ?? "{}");
    expect(body).toEqual({ decision: "approved", version: 1 });
    expect(textOf(screen.getByTestId(`approval-detail-strip-${T}`))).toContain("DECIDED");
    expect(textOf(screen.getByTestId(`approval-detail-closed-${T}`))).toContain("Decided approved");
  });

  it("shows the retry line when the model summary hit a transient upstream failure", async () => {
    renderApprovalPage([
      {
        path: SUMMARY_PATH,
        method: "POST",
        status: 503,
        body: { ...NOT_CONFIGURED, degraded: "model_unreachable" },
      },
      { path: ARTIFACTS_PATH, body: { artifacts: [] } },
    ]);

    expect(await screen.findByTestId(`approval-detail-summary-fallback-${T}`)).toBeTruthy();
    expect(screen.getByText(/The assistant's model is unavailable right now/)).toBeTruthy();
    // The gate's own summary still backs the decider — never a blocked gate.
    const fallbackText = textOf(screen.getByTestId(`approval-detail-summary-fallback-${T}`));
    expect(fallbackText).toContain(wireApproval.summary);
  });

  it("shows the model summary, risk-colored actions and the plan inline", async () => {
    renderApprovalPage([
      {
        path: SUMMARY_PATH,
        method: "POST",
        body: {
          summary: "A per-key limiter backed by Redis: 60 requests a minute, burst 20.",
          actions: [
            { label: "Approve plan", intent: "approve", risk: "proceed" },
            { label: "Reject and stop the run", intent: "reject", risk: "destructive" },
          ],
          model: "claude-opus-4-5",
          generated_at: "2026-07-31T10:50:00Z",
        },
      },
      { path: ARTIFACTS_PATH, body: { artifacts: [planArtifact] } },
      { path: CONTENT_PATH, body: PLAN_CONTENT },
    ]);

    await screen.findByTestId(`approval-detail-strip-${T}`);
    const summary = await screen.findByTestId(`approval-detail-summary-${T}`);
    expect(textOf(summary)).toContain("A per-key limiter backed by Redis");
    expect(screen.getByText(/summary by claude-opus-4-5/)).toBeTruthy();

    const suggested = screen.getByTestId(`approval-detail-suggested-${T}`);
    const approve = within(suggested).getByTestId(`approval-detail-suggested-${T}-approve`);
    const reject = within(suggested).getByTestId(`approval-detail-suggested-${T}-reject`);
    expect(textOf(approve)).toBe("Approve plan");
    expect(textOf(reject)).toBe("Reject and stop the run");
    expect(reject.className).toContain("ds-btn--danger");

    const plan = await screen.findByTestId(`approval-detail-plan-body-${T}`);
    expect(textOf(plan)).toContain("Token bucket per API key, stored in Redis.");
    expect(textOf(plan)).toContain("The 61st request gets 429.");
  });

  it("interprets a free-text reply and decides only from the confirmed proposal", async () => {
    const { requests } = renderApprovalPage([
      {
        path: SUMMARY_PATH,
        method: "POST",
        body: {
          summary: "A per-key limiter backed by Redis.",
          actions: [{ label: "Approve plan", intent: "approve", risk: "proceed" }],
          model: "claude-opus-4-5",
          generated_at: "2026-07-31T10:50:00Z",
        },
      },
      {
        path: INTERPRET_PATH,
        method: "POST",
        body: {
          interpretation: "You approve, but paid keys should get 300 a minute.",
          proposed: { decision: "approve", comments: "Paid keys get 300/min." },
        },
      },
      { path: ARTIFACTS_PATH, body: { artifacts: [planArtifact] } },
      { path: CONTENT_PATH, body: PLAN_CONTENT },
    ]);

    await screen.findByTestId(`approval-detail-strip-${T}`);
    const reply = screen.getByTestId(`approval-detail-reply-${T}`);
    fireEvent.change(reply, { target: { value: "Approve, but paid keys get 300/min" } });
    fireEvent.click(screen.getByTestId(`approval-detail-reply-send-${T}`));

    const proposal = await screen.findByTestId(`approval-detail-proposal-${T}`);
    expect(textOf(proposal)).toContain("You approve, but paid keys should get 300 a minute.");
    expect(textOf(proposal)).toContain("approved");
    expect(requestsTo(requests, DECIDE_PATH, "POST")).toHaveLength(0);

    // The proposal's confirm button opens the confirm step, not decide.
    fireEvent.click(within(proposal).getByTestId(`approval-detail-proposal-confirm-${T}`));
    const dialog = screen.getByTestId(`approval-detail-confirm-${T}`);
    expect(textOf(dialog)).toContain("Approve with note");
    const note = document.getElementById(`approval-detail-confirm-note-${T}`);
    expect(note).toBeTruthy();
    expect((note as HTMLTextAreaElement).value).toBe("Paid keys get 300/min.");
    expect(requestsTo(requests, DECIDE_PATH, "POST")).toHaveLength(0);

    fireEvent.click(screen.getByTestId(`approval-detail-confirm-go-${T}`));
    await waitFor(() => expect(requestsTo(requests, DECIDE_PATH, "POST")).toHaveLength(1));
    const body = JSON.parse(requestsTo(requests, DECIDE_PATH, "POST")[0].body ?? "{}");
    expect(body).toEqual({
      decision: "approved",
      comments: "Paid keys get 300/min.",
      version: 1,
    });
    expect(textOf(screen.getByTestId(`approval-detail-strip-${T}`))).toContain("DECIDED");
  });
});
