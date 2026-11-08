/**
 * DecisionBar against the fake fetch with fake timers: the 5s undo hold is the
 * whole contract — no POST before it expires, Undo sends nothing, one POST
 * after it, an unmount flushes the decision, a 409 adopts the winner in
 * words, and Request changes rides the same hold as `rejected` + comments.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import DecisionBar, { DECISION_HOLD_SECONDS } from "./DecisionBar";
import type { DecisionConflict } from "./DecisionBar";
import { queryKeys } from "../../api/queries";
import { homeKeys } from "../../api/home";
import {
  baseRoutes,
  mockFetch,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../../test/fakes";

const approval = {
  id: "01987a90-1111-7000-8000-aaaaaaaaaaaa",
  project_id: projectFixture.id,
  version: 3,
};
const decidePath = `/api/v1/approvals/${approval.id}/decide`;

function harness(routes: RouteStub[]) {
  const { requests } = mockFetch([
    // The bar reads the actor directory for a conflict's decider, so every
    // harness answers the directory routes; a test that wants a specific name
    // passes its own `users` stub on top (first match wins).
    ...routes,
    ...baseRoutes(),
  ]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { wrapper, requests, client };
}

function posted(requests: ReturnType<typeof mockFetch>["requests"]) {
  return requestsTo(requests, decidePath, "POST").map((request) =>
    JSON.parse(request.body ?? "{}"),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("DecisionBar", () => {
  it("holds the POST for 5s behind a counting-down Undo line, then posts once", async () => {
    const decided = { ...approval, state: "decided", decision: "approved", version: 4 };
    const { wrapper, requests } = harness([{ path: decidePath, method: "POST", body: decided }]);
    render(<DecisionBar approval={approval} />, { wrapper });

    fireEvent.click(screen.getByTestId("decision-approve"));
    expect(screen.getByTestId("decision-status").textContent).toBe(
      `Approved. The run continues in ${DECISION_HOLD_SECONDS}s. Undo`,
    );
    expect(document.activeElement?.getAttribute("data-testid")).toBe("decision-undo");
    expect(screen.queryByTestId("decision-approve")).toBeNull();
    expect(posted(requests)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(4000);
    expect(screen.getByTestId("decision-status").textContent).toContain("The run continues in 1s.");
    expect(posted(requests)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(posted(requests)).toHaveLength(1);
    expect(posted(requests)[0]).toEqual({ decision: "approved", version: 3 });
  });

  it("Undo cancels the hold: no POST, the bar comes back", async () => {
    const { wrapper, requests } = harness([]);
    render(<DecisionBar approval={approval} />, { wrapper });

    fireEvent.click(screen.getByTestId("decision-reject"));
    expect(screen.getByTestId("decision-status").textContent).toContain("Rejected. The run");
    fireEvent.click(screen.getByTestId("decision-undo"));

    expect(screen.getByTestId("decision-approve")).toBeTruthy();
    expect(screen.queryByTestId("decision-status")).toBeNull();
    await vi.advanceTimersByTimeAsync(30000);
    expect(posted(requests)).toHaveLength(0);
  });

  it("unmounting during the hold sends the decision immediately", async () => {
    const decided = { ...approval, state: "decided", decision: "approved", version: 4 };
    const { wrapper, requests } = harness([{ path: decidePath, method: "POST", body: decided }]);
    const view = render(<DecisionBar approval={approval} />, { wrapper });

    fireEvent.click(screen.getByTestId("decision-approve"));
    view.unmount();
    await vi.advanceTimersByTimeAsync(0);
    expect(posted(requests)).toHaveLength(1);
    expect(posted(requests)[0]).toEqual({ decision: "approved", version: 3 });
  });

  it("a cache update to decided-by-B during the hold sends nothing and names B", async () => {
    // Finding 04: the live `approval.decided` frame moves the shared row
    // while the hold is open. The bar must cancel the hold, post NOTHING
    // (no silent 409), and print the winner's sentence instead.
    const winner = {
      id: "01987a63-7777-7000-8000-cccc00000002",
      display_name: "Grace Hopper",
      email: null,
    };
    const { wrapper, requests, client } = harness([
      { path: "/api/v1/users", body: { items: [winner] } },
      { path: `/api/v1/projects/${approval.project_id}/members`, body: { items: [] } },
    ]);
    render(<DecisionBar approval={approval} />, { wrapper });

    fireEvent.click(screen.getByTestId("decision-approve"));
    expect(screen.getByTestId("decision-status").textContent).toContain("The run continues in");

    // The shared row moves under the hold — the same cache write
    // `useApproval`'s refetch or a conflict adoption produces.
    act(() => {
      client.setQueryData(queryKeys.approval(approval.id), {
        ...approval,
        state: "decided",
        decision: "approved",
        decided_by: winner.id,
        decided_at: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
        version: 4,
      });
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(posted(requests)).toHaveLength(0);
    expect(screen.getByTestId("decision-conflict").textContent).toContain(
      "Grace Hopper approved this 4m ago. Your decision wasn't recorded.",
    );
    expect(screen.queryByTestId("decision-approve")).toBeNull();
    expect(screen.queryByText(/Your decision is recorded/)).toBeNull();
  });

  it("a lost race reported through onConflict lets the host keep the sentence sticky", async () => {
    // The host-side contract: a watched-away conflict reports immediately
    // (facts pending), then re-reports once the single gate read names the
    // winner; and a bar booted from `initialConflict` renders the SAME
    // sentence with no buttons and no POST of its own.
    const winner = {
      id: "01987a63-7777-7000-8000-cccc00000003",
      display_name: "Alan Turing",
      email: null,
    };
    const decidedRow = {
      ...approval,
      state: "decided",
      decision: "rejected",
      decided_by: winner.id,
      decided_at: new Date(Date.now() - 60 * 1000).toISOString(),
      version: 4,
    };
    const { wrapper, requests, client } = harness([
      { path: `/api/v1/approvals/${approval.id}`, method: "GET", body: decidedRow },
      { path: "/api/v1/users", body: { items: [winner] } },
      { path: `/api/v1/projects/${approval.project_id}/members`, body: { items: [] } },
    ]);
    const reports: DecisionConflict[] = [];
    // The gate sits in the briefing's pending list — the list the live frame
    // is about to drop it from.
    client.setQueryData(homeKeys.approvals, { approvals: [{ ...approval, state: "pending" }] });
    const view = render(<DecisionBar approval={approval} onConflict={(c) => reports.push(c)} />, {
      wrapper,
    });

    fireEvent.click(screen.getByTestId("decision-reject"));
    act(() => {
      client.setQueryData(homeKeys.approvals, { approvals: [] });
    });
    // Reported at once, before any name was served…
    expect(reports[0]).toEqual({
      approvalId: approval.id,
      verb: "rejected",
      deciderId: null,
      decidedAt: null,
    });
    // …the disappearance alone stops the POST, and the one row read fills in
    // the person (so the host stores the named report too).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(posted(requests)).toHaveLength(0);
    expect(requestsTo(requests, `/api/v1/approvals/${approval.id}`, "GET")).toHaveLength(1);
    expect(reports.length).toBe(2);
    expect(reports[1].deciderId).toBe(winner.id);
    // The name rides the directory read the named report re-arms — one more
    // pump for that fetch to land and re-render the sentence.
    await vi.advanceTimersByTimeAsync(1000);
    expect(screen.getByTestId("decision-conflict").textContent).toContain(
      "Alan Turing rejected this 1m ago. Your decision wasn't recorded.",
    );
    view.unmount();
    expect(posted(requests)).toHaveLength(0);

    // The sticky re-render: a bar mounted from the stored report prints the
    // sentence directly — no verbs, no cache watch, no network beyond the
    // directory it already answered from.
    render(<DecisionBar approval={approval} initialConflict={reports[1]} />, { wrapper });
    await vi.advanceTimersByTimeAsync(100);
    expect(screen.getByTestId("decision-conflict").textContent).toContain(
      "Alan Turing rejected this",
    );
    expect(screen.queryByTestId("decision-approve")).toBeNull();
  });

  it("Request changes needs text and posts rejected with the comments", async () => {
    const decided = { ...approval, state: "decided", decision: "rejected", version: 4 };
    const { wrapper, requests } = harness([{ path: decidePath, method: "POST", body: decided }]);
    render(<DecisionBar approval={approval} />, { wrapper });

    fireEvent.click(screen.getByTestId("decision-request-changes"));
    const box = screen.getByTestId("decision-changes-text");
    expect((screen.getByTestId("decision-changes-send") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(box, { target: { value: "Rename the flag first." } });
    fireEvent.click(screen.getByTestId("decision-changes-send"));
    expect(screen.getByTestId("decision-status").textContent).toContain(
      "Changes requested. The run continues in",
    );

    await vi.advanceTimersByTimeAsync(5000);
    expect(posted(requests)).toHaveLength(1);
    expect(posted(requests)[0]).toEqual({
      decision: "rejected",
      comments: "Rename the flag first.",
      version: 3,
    });
  });

  it("a 409 renders the winner's sentence and no bar", async () => {
    const conflictBody = {
      type: "https://communication.dev/problems/approval-already-decided",
      title: "already decided",
      status: 409,
      detail: "someone else won the click",
      approval_id: approval.id,
      approval: { state: "decided", decision: "approved", decided_by: "u-1", version: 4 },
    };
    const { wrapper, requests } = harness([
      { path: decidePath, method: "POST", status: 409, body: conflictBody },
    ]);
    render(<DecisionBar approval={approval} />, { wrapper });

    fireEvent.click(screen.getByTestId("decision-approve"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(posted(requests)).toHaveLength(1);
    expect(screen.getByTestId("decision-conflict").textContent).toContain(
      "Someone approved this a moment ago. Your decision wasn't recorded.",
    );
    expect(screen.queryByTestId("decision-approve")).toBeNull();
  });

  it("a 409 offers See the run when the gate's row carries a run id", async () => {
    // Finding 12: every error ends in an action. The conflict names who decided;
    // with the gate's `run_id` the line also links to the run they decided on.
    const conflictBody = {
      type: "https://communication.dev/problems/approval-already-decided",
      title: "already decided",
      status: 409,
      approval_id: approval.id,
      approval: { state: "decided", decision: "approved", decided_by: "u-1", version: 4 },
    };
    const { wrapper } = harness([
      { path: decidePath, method: "POST", status: 409, body: conflictBody },
    ]);
    render(
      <DecisionBar approval={{ ...approval, run_id: "01987b00-2222-7000-8000-bbbbbbbbbbbb" }} />,
      {
        wrapper,
      },
    );

    fireEvent.click(screen.getByTestId("decision-approve"));
    await vi.advanceTimersByTimeAsync(5000);
    const link = screen.getByTestId("decision-conflict-run");
    expect(link.textContent).toBe("See the run");
    expect(link.getAttribute("href")).toBe("/runs/01987b00-2222-7000-8000-bbbbbbbbbbbb");
    // A row with no run id keeps the sentence and gets no link (the test above
    // asserts that shape by absence: `decision-conflict-run` is not rendered).
  });

  it("a 409 names the person the directory knows, with the age the body serves", async () => {
    // T10b: the conflict body carries `decided_by` — a user id — and the bar's
    // sentence is a name. The directory the app already reads (`/api/v1/users`,
    // the same one the transcript and the decision record use) resolves it; a
    // uuid in that sentence is the bug this guards.
    const winner = {
      id: "01987a63-7777-7000-8000-cccc00000001",
      display_name: "Ada Lovelace",
      email: null,
    };
    const conflictBody = {
      type: "https://communication.dev/errors/approval-already-decided",
      title: "Approval Already Decided",
      status: 409,
      detail: "the winner's click arrived first",
      approval_id: approval.id,
      approval: {
        state: "decided",
        decision: "approved",
        decided_by: winner.id,
        // The one timestamp the body may serve; the age is measured from it.
        decided_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        version: 4,
      },
    };
    const { wrapper } = harness([
      { path: decidePath, method: "POST", status: 409, body: conflictBody },
      { path: "/api/v1/users", body: { items: [winner] } },
      { path: `/api/v1/projects/${projectFixture.id}/members`, body: { items: [] } },
    ]);
    render(<DecisionBar approval={approval} />, { wrapper });

    fireEvent.click(screen.getByTestId("decision-approve"));
    await vi.advanceTimersByTimeAsync(5000);
    // The name arrives with the directory read, so the sentence is re-rendered
    // once `/api/v1/users` answers — the fake timer advance lets both reads land.
    await vi.advanceTimersByTimeAsync(1000);
    expect(screen.getByTestId("decision-conflict").textContent).toContain(
      "Ada Lovelace approved this 5m ago. Your decision wasn't recorded.",
    );
    expect(screen.getByTestId("decision-conflict").textContent).not.toContain(winner.id);
    expect(screen.queryByTestId("decision-approve")).toBeNull();
    expect(screen.queryByText(/Your decision is recorded/)).toBeNull();
  });

  it("says Someone only for a decider the directory cannot name", async () => {
    const conflictBody = {
      type: "https://communication.dev/errors/approval-already-decided",
      title: "Approval Already Decided",
      status: 409,
      detail: "someone else won the click",
      approval_id: approval.id,
      approval: { state: "decided", decision: "rejected", decided_by: "u-1", version: 4 },
    };
    const { wrapper } = harness([
      { path: decidePath, method: "POST", status: 409, body: conflictBody },
      { path: "/api/v1/users", body: { items: [] } },
      { path: `/api/v1/projects/${projectFixture.id}/members`, body: { items: [] } },
    ]);
    render(<DecisionBar approval={approval} />, { wrapper });

    fireEvent.click(screen.getByTestId("decision-reject"));
    await vi.advanceTimersByTimeAsync(6000);
    // A stranger gets the honest word, never a bare uuid (`names.ts`'s rule).
    expect(screen.getByTestId("decision-conflict").textContent).toContain(
      "Someone rejected this a moment ago. Your decision wasn't recorded.",
    );
    expect(screen.queryByText(/Your decision is recorded/)).toBeNull();
  });
  it("a plain error restores the bar with a Try again line", async () => {
    const { wrapper, requests } = harness([
      { path: decidePath, method: "POST", status: 500, body: { title: "boom", status: 500 } },
    ]);
    render(<DecisionBar approval={approval} />, { wrapper });

    fireEvent.click(screen.getByTestId("decision-reject"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(posted(requests)).toHaveLength(1);
    expect(screen.getByTestId("decision-error").textContent).toContain("Try again.");
    expect(screen.getByTestId("decision-approve")).toBeTruthy();
  });
});
