/**
 * The 4g approval detail as a real route. The contract under test:
 * - a 503 `assistant_not_configured` names the cause and falls back to the
 *   gate's own summary — never a fake model voice;
 * - NOTHING decides during the undo hold: the decide route is not called
 *   until the 5s hold expires, and Undo cancels it without deciding
 *   (finding 04 — no confirm step, no "not a decision word" path);
 * - the decide verbs are fixed (`DecisionBar`), never model-written, and the
 *   plan artifact renders inline from `/artifacts/{id}/content`;
 * - "OR IN YOUR WORDS" → interpret → the proposal is shown as TEXT above the
 *   bar and decides nothing by itself;
 * - a `404` (M4 contract § 7.2 W9: an outsider deep-links a gate they cannot
 *   see) renders an honest not-found state in plain words — no scaffold, no
 *   project name — and links back to the Inbox.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function renderApprovalPage(extra: RouteStub[], prepend: RouteStub[] = []) {
  const { requests } = mockFetch([...prepend, ...BASE_STUBS, ...extra]);
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

    // Finding 04: no model voice on the verbs — the shared DecisionBar's
    // fixed Approve / Request changes / Reject, styled by verb not by risk.
    expect(textOf(screen.getByTestId("decision-approve"))).toBe("Approve");
    expect(screen.getByTestId("decision-approve").className).toContain("ds-btn--primary");
    expect(screen.getByTestId("decision-request-changes").className).toContain("ds-btn--secondary");
    expect(textOf(screen.getByTestId("decision-reject"))).toBe("Reject");
    expect(screen.getByTestId("decision-reject").className).toContain("ds-btn--danger");

    expect(textOf(screen.getByTestId(`approval-detail-files-${T}`))).toContain("Not available yet");
    expect(textOf(await screen.findByText(/named by the gate but not in this project/))).toContain(
      "artifact list",
    );
  });

  it("holds the decision for the undo window; only the expired hold posts, with the CAS version", async () => {
    const { requests } = renderApprovalPage([
      { path: SUMMARY_PATH, method: "POST", status: 503, body: NOT_CONFIGURED },
      { path: ARTIFACTS_PATH, body: { artifacts: [] } },
    ]);

    await screen.findByTestId(`approval-detail-strip-${T}`);
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByTestId("decision-approve"));
      expect(textOf(screen.getByTestId("decision-status"))).toContain(
        "Approved. The run continues in 5s.",
      );
      expect(requestsTo(requests, DECIDE_PATH, "POST")).toHaveLength(0);

      // Undo cancels the hold without deciding and restores the bar.
      fireEvent.click(screen.getByTestId("decision-undo"));
      expect(screen.getByTestId("decision-approve")).toBeTruthy();
      await vi.advanceTimersByTimeAsync(6100);
      expect(requestsTo(requests, DECIDE_PATH, "POST")).toHaveLength(0);

      // Letting the hold expire posts exactly once, with the CAS version.
      fireEvent.click(screen.getByTestId("decision-approve"));
      await vi.advanceTimersByTimeAsync(5000);
      expect(requestsTo(requests, DECIDE_PATH, "POST")).toHaveLength(1);
      const body = JSON.parse(requestsTo(requests, DECIDE_PATH, "POST")[0].body ?? "{}");
      expect(body).toEqual({ decision: "approved", version: 1 });

      // The winner's row lands in the cache: the strip and the rail close.
      await vi.advanceTimersByTimeAsync(100);
      expect(textOf(screen.getByTestId(`approval-detail-strip-${T}`))).toContain("DECIDED");
      expect(textOf(screen.getByTestId(`approval-detail-closed-${T}`))).toContain(
        "Decided approved",
      );
    } finally {
      vi.useRealTimers();
    }
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

    // The model's labels are gone: the verbs are the bar's, fixed.
    expect(screen.queryByTestId(`approval-detail-suggested-${T}`)).toBeNull();
    expect(screen.queryByText("Approve plan")).toBeNull();
    expect(screen.getByTestId("decision-approve")).toBeTruthy();
    expect(screen.getByTestId("decision-request-changes")).toBeTruthy();

    const plan = await screen.findByTestId(`approval-detail-plan-body-${T}`);
    expect(textOf(plan)).toContain("Token bucket per API key, stored in Redis.");
    expect(textOf(plan)).toContain("The 61st request gets 429.");
  });

  it("interprets a free-text reply into TEXT above the bar — the proposal decides nothing", async () => {
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

    // The reading is TEXT above the bar: no confirm step, no decide call.
    expect(screen.queryByTestId(`approval-detail-confirm-${T}`)).toBeNull();
    expect(textOf(proposal)).toContain("reads like");
    expect(requestsTo(requests, DECIDE_PATH, "POST")).toHaveLength(0);

    // The human decides with the bar; "Request changes" carries the note —
    // through the undo hold, so nothing is posted until it expires.
    fireEvent.click(screen.getByTestId("decision-request-changes"));
    fireEvent.change(screen.getByTestId("decision-changes-text"), {
      target: { value: "Paid keys get 300/min." },
    });
    fireEvent.click(screen.getByTestId("decision-changes-send"));
    expect(textOf(screen.getByTestId("decision-status"))).toContain("Changes requested.");
    expect(requestsTo(requests, DECIDE_PATH, "POST")).toHaveLength(0);

    fireEvent.click(screen.getByTestId("decision-undo"));
    expect(screen.getByTestId("decision-approve")).toBeTruthy();
    expect(requestsTo(requests, DECIDE_PATH, "POST")).toHaveLength(0);
  });

  it("promises the THEN line the engine actually performs — rejecting is a business outcome", async () => {
    // The old copy said "a rejection fails it"; the engine closes the gate
    // `succeeded` with outcome `rejected` and the guarded dependants skip
    // (`docs/m4-contract.md` § 5.3, C9e). The rail must state that truth, and
    // the false promise is now a regression guard.
    renderApprovalPage([
      { path: SUMMARY_PATH, method: "POST", status: 503, body: NOT_CONFIGURED },
      { path: ARTIFACTS_PATH, body: { artifacts: [] } },
    ]);
    const then = await screen.findByTestId("approval-detail-then");
    expect(textOf(then)).toContain(wireApproval.node_instance_key);
    expect(textOf(then)).toContain("rejecting records the decision as a business outcome");
    expect(textOf(then)).toContain("steps that need approval won't run");
    expect(textOf(then)).not.toMatch(/rejection\s+fails|fails it/);
  });

  // M4 contract § 7.2 W9: an outsider (a member of no project that owns the
  // gate) deep-links /approvals/{id}. The control plane answers 404; the page
  // must render an honest not-found state — never a blank page, never a
  // spinner, never a "could not be read" shrug, and never a project name.
  it("renders an honest not-found state when the gate answers 404 (W9 outsider deep link)", async () => {
    const NOT_FOUND = {
      type: "https://communication.dev/errors/not-found",
      title: "Not found",
      status: 404,
      detail: "No such approval.",
    };
    // First stub wins, so the 404 must precede BASE_STUBS' 200 for the path.
    const { requests } = renderApprovalPage(
      [],
      [{ path: APPROVAL_PATH, method: "GET", status: 404, body: NOT_FOUND }],
    );

    const notFound = await screen.findByTestId("approval-not-found");
    const copy = textOf(notFound);
    // Plain user words (orchestrator review), and the arm-facing ones: the M4
    // exit driver (w9_not_found) reads the outsider's page by looking for
    // "not found" / "does not exist" / "not visible" / "no such" / "404" —
    // "not found" here is what keeps that contract arm measurable, so this
    // copy pins both phrasings.
    expect(copy).toContain("Approval not found");
    expect(copy.toLowerCase()).toContain("not found");
    expect(copy).toContain("This approval doesn't exist, or you don't have access to it.");
    // The way back is the reader's own Inbox, not a scaffold for the gate.
    const back = within(notFound).getByRole("link", { name: "Back to Inbox" });
    expect(back.getAttribute("href")).toBe("/inbox");
    // The gate's own scaffold is gone: no strip, no summary, no decide rail.
    expect(screen.queryByTestId(`approval-detail-strip-${T}`)).toBeNull();
    expect(screen.queryByTestId(`approval-detail-loading`)).toBeNull();
    // Nothing that could identify the gate's project appears anywhere.
    expect(document.body.textContent).not.toContain(projectFixture.name);
    // Only the gate read itself was asked for — no member-side follow-ups.
    expect(requestsTo(requests, DECIDE_PATH, "POST")).toHaveLength(0);
    expect(requestsTo(requests, SUMMARY_PATH, "POST")).toHaveLength(0);
  });

  it("keeps the problem banner for a non-404 failure — the 404 state is for 404s only", async () => {
    renderApprovalPage(
      [],
      [
        {
          path: APPROVAL_PATH,
          method: "GET",
          status: 500,
          body: { type: "x", title: "Boom", status: 500, detail: "internal" },
        },
      ],
    );
    const banner = await screen.findByRole("alert");
    expect(textOf(banner)).toContain("Boom");
    expect(screen.queryByTestId("approval-not-found")).toBeNull();
  });
});
