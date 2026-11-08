/**
 * DecisionBar against the fake fetch with fake timers: the 5s undo hold is the
 * whole contract — no POST before it expires, Undo sends nothing, one POST
 * after it, an unmount flushes the decision, a 409 adopts the winner in
 * words, and Request changes rides the same hold as `rejected` + comments.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import DecisionBar, { DECISION_HOLD_SECONDS } from "./DecisionBar";
import { mockFetch, projectFixture, requestsTo, type RouteStub } from "../../test/fakes";

const approval = {
  id: "01987a90-1111-7000-8000-aaaaaaaaaaaa",
  project_id: projectFixture.id,
  version: 3,
};
const decidePath = `/api/v1/approvals/${approval.id}/decide`;

function harness(routes: RouteStub[]) {
  const { requests } = mockFetch(routes);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { wrapper, requests };
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
