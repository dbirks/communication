/**
 * The Home briefing sections against the fake fetch: the "running now"
 * row (one 7px segment per step, honest names only), the decision callout
 * (the gate's own summary, always a confirm before Approve posts) and the
 * recent-threads rows (manual conversations only, names from the lists the
 * briefing already holds).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { RunningNow } from "./RunningNow";
import { DecisionCallouts } from "./DecisionCallout";
import { RecentThreads } from "./RecentThreads";
import type { CrossProjectRunSummary } from "../../api/home";
import {
  conversationSummaryFixture,
  mockFetch,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../../test/fakes";
import type { Approval } from "../../api/types";

const runFixture: CrossProjectRunSummary = {
  id: "01987a9a-4444-7000-8000-dddddddddddd",
  project_id: projectFixture.id,
  pipeline_id: "01987a9a-5555-7000-8000-eeeeeeeeeeee",
  pipeline_revision_id: "01987a9a-6666-7000-8000-ffffffffffff",
  revision_digest: "rev-digest",
  plan_digest: "plan-digest",
  status: "running",
  depth: 0,
  priority: 0,
  created_at: "2026-10-14T17:42:00Z",
  project_name: "acme-web",
  pipeline_slug: "feature-delivery",
  pipeline_display_name: "Feature Delivery",
  steps: [
    { node_id: "plan", kind: "agent.acp", state: "succeeded" },
    { node_id: "implement", kind: "agent.acp", state: "running" },
    { node_id: "review", kind: "agent.acp", state: "pending" },
    { node_id: "ship", kind: "agent.acp", state: "pending" },
  ],
};

const approvalFixture: Approval = {
  id: "01987a90-1111-7000-8000-aaaaaaaaaaaa",
  project_id: projectFixture.id,
  run_id: "01987a90-2222-7000-8000-bbbbbbbbbbbb",
  node_execution_id: "01987a90-3333-7000-8000-cccccccccccc",
  kind: "pipeline_gate",
  summary: "Approve plan: rate limiter for /v2/search.",
  artifact_refs: [],
  approver_roles: ["maintainer"],
  approver_user_ids: ["01987a70-9999-7000-8000-000000000001"],
  deadline_at: "2026-10-15T18:00:00Z",
  on_timeout: "fail",
  re_requested: false,
  state: "pending",
  version: 3,
  created_at: "2026-10-14T16:00:00Z",
};

function harness(routes: RouteStub[]) {
  const { requests } = mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 60_000 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return { requests, wrapper };
}

afterEach(cleanup);

describe("RunningNow", () => {
  it("renders one row per run: workflow names, one segment per step, the current step and the run link", () => {
    const { wrapper } = harness([]);
    render(<RunningNow runs={[runFixture]} />, { wrapper });

    const row = screen.getByTestId("home-run-progress-01987a9a44447");
    expect(row.getAttribute("aria-label")).toBe("1 of 4 steps done, 1 running");
    expect(row.querySelectorAll("span").length).toBe(4);
    // Equal-width segments filling the column: flex-basis 0 / grow 1 each,
    // the 2px gap is the transparent 1px edges, and pending reads white
    // inside the bar's line border.
    const [second] = Array.from(row.children) as HTMLElement[];
    expect(second.style.flexGrow).toBe("1");
    expect(second.style.flexBasis).toBe("0px");
    expect(row.className).toContain("w-full");

    expect(screen.getByText("Feature Delivery")).toBeTruthy();
    expect(screen.getByText("feature-delivery #dddddddd · acme-web")).toBeTruthy();
    expect(screen.getByTestId("home-run-step-01987a9a44447").textContent).toBe("implement · 2/4");

    const link = screen.getByTestId("home-run-progress-01987a9a44447").closest("a");
    expect(link?.getAttribute("href")).toBe("/runs/01987a9a-4444-7000-8000-dddddddddddd");
    expect(screen.getByTestId("home-open-board").getAttribute("href")).toBe("/board");
  });

  it("puts the run's own title first when the API serves one (ADR-0064)", () => {
    const { wrapper } = harness([]);
    const titled: CrossProjectRunSummary = {
      ...runFixture,
      id: "01987a9a-4444-7000-8000-00000000d001",
      title: "Add saved cards to checkout",
    };
    render(<RunningNow runs={[titled, runFixture]} />, { wrapper });
    expect(screen.getByText("Add saved cards to checkout")).toBeTruthy();
    // The unnamed run keeps the workflow-display-name fallback — the title
    // never bleeds across rows and nothing is invented for it.
    expect(screen.getByText("Feature Delivery")).toBeTruthy();
  });

  it("spells the waiting count in the bar's label before the running one", () => {
    const { wrapper } = harness([]);
    const gated: CrossProjectRunSummary = {
      ...runFixture,
      steps: [
        { node_id: "plan", kind: "agent.acp", state: "succeeded" },
        { node_id: "review", kind: "agent.acp", state: "succeeded" },
        { node_id: "approve", kind: "approval_gate", state: "waiting" },
        { node_id: "ship", kind: "agent.acp", state: "pending" },
      ],
    };
    render(<RunningNow runs={[gated]} />, { wrapper });
    expect(screen.getByTestId("home-run-progress-01987a9a44447").getAttribute("aria-label")).toBe(
      "2 of 4 steps done, 1 waiting",
    );
  });

  it("shows an honest dash when the run carries no steps", () => {
    const { wrapper } = harness([]);
    render(<RunningNow runs={[{ ...runFixture, steps: [] }]} />, { wrapper });
    expect(screen.getByTestId("home-run-progress-01987a9a44447").textContent).toBe("—");
    expect(screen.getByTestId("home-run-step-01987a9a44447").textContent).toBe("—");
  });
});

describe("DecisionCallouts", () => {
  it("labels the gate's own summary 'from the workflow' and names the workflow, run and project", () => {
    const { wrapper } = harness([]);
    render(<DecisionCallouts approvals={[approvalFixture]} runs={[]} />, { wrapper });
    expect(screen.getByText("from the workflow")).toBeTruthy();
    expect(screen.getByText("Approve plan: rate limiter for /v2/search.")).toBeTruthy();
    expect(screen.getByText(/run #bbbbbbbb/)).toBeTruthy();
  });

  it("caps at three callouts and points the rest at the Inbox", () => {
    const { wrapper } = harness([]);
    const many = [0, 1, 2, 3].map((index) => ({
      ...approvalFixture,
      id: `01987a90-999${index}-7000-8000-${index}${index}${index}${index}`,
    }));
    render(<DecisionCallouts approvals={many} runs={[]} />, { wrapper });
    expect(screen.getByText("1 more in Inbox ›")).toBeTruthy();
    expect(screen.getByTestId("home-more-inbox").getAttribute("href")).toBe("/inbox");
  });

  it("Approve always asks for a confirmation; only the confirm posts the decision", async () => {
    const decided: Approval = {
      ...approvalFixture,
      state: "decided",
      decision: "approved",
      version: 4,
    };
    const { requests, wrapper } = harness([
      { path: `/api/v1/approvals/${approvalFixture.id}/decide`, method: "POST", body: decided },
    ]);
    const user = { click: (el: HTMLElement) => fireEvent.click(el) };
    render(<DecisionCallouts approvals={[approvalFixture]} runs={[]} />, { wrapper });

    await user.click(screen.getByTestId("home-approve-01987a9011117"));
    expect(
      requestsTo(requests, `/api/v1/approvals/${approvalFixture.id}/decide`, "POST"),
    ).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe("approve this gate?");

    await user.click(screen.getByTestId("home-approve-confirm-01987a9011117"));
    await waitFor(() =>
      expect(
        requestsTo(requests, `/api/v1/approvals/${approvalFixture.id}/decide`, "POST"),
      ).toHaveLength(1),
    );
    const body = JSON.parse(
      requestsTo(requests, `/api/v1/approvals/${approvalFixture.id}/decide`, "POST")[0].body ??
        "{}",
    );
    expect(body).toEqual({ decision: "approved", version: 3 });
  });

  it("the Read plan link leaves for the gate's own detail page (ADR-0052)", () => {
    const { wrapper } = harness([]);
    render(<DecisionCallouts approvals={[approvalFixture]} runs={[]} />, { wrapper });
    expect(screen.getByTestId("home-read-plan-01987a9011117").getAttribute("href")).toBe(
      `/approvals/${approvalFixture.id}`,
    );
  });
});

describe("RecentThreads", () => {
  const projectNames = new Map([[projectFixture.id, "acme-api"]]);
  const profileNames = new Map([[conversationSummaryFixture.agent_profile_id, "Claude Code"]]);

  it("renders the manual rows with project, profile and age, linking to the thread", () => {
    const { wrapper } = harness([]);
    render(
      <RecentThreads
        threads={[conversationSummaryFixture]}
        projectNames={projectNames}
        profileNames={profileNames}
      />,
      { wrapper },
    );
    expect(screen.getByText("Refactor billing")).toBeTruthy();
    expect(screen.getByText("acme-api · Claude Code")).toBeTruthy();
    const link = screen.getByText("Refactor billing").closest("a");
    expect(link?.getAttribute("href")).toBe(`/threads/${conversationSummaryFixture.id}`);
    expect(screen.getByTestId("home-all-threads").getAttribute("href")).toBe("/threads");
  });

  it("shows the honest empty state with a New thread action", () => {
    const { wrapper } = harness([]);
    render(<RecentThreads threads={[]} projectNames={projectNames} profileNames={profileNames} />, {
      wrapper,
    });
    expect(screen.getByText("No one-off threads yet.")).toBeTruthy();
    expect(screen.getByTestId("home-new-thread")).toBeTruthy();
  });
});
